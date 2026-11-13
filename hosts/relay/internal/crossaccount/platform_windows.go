//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func managerGuard() error {
	sid, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	admin, err := windows.Token(0).IsMember(sid)
	if err != nil {
		return err
	}
	if !admin {
		return errors.New("service manager requires an elevated administrator")
	}
	return nil
}
func prepareStage(stage string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "icacls.exe"), stage, "/grant", "*S-1-5-19:(OI)(CI)(M)")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("grant fixture stage access: %w", err)
	}
	return nil
}
func prepareSocket(string) error { return nil }
func isClosed(err error) bool {
	return errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) || errors.Is(err, windows.WSAECONNREFUSED)
}
func isPermission(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.WSAEACCES)
}
func verifyIdentity(r request) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return phase("token-user", err)
	}
	if user.User.Sid.String() != "S-1-5-19" {
		return phase("not-localservice", errors.New("unexpected service principal"))
	}
	if r.Owner == "" {
		return phase("owner-sid-missing", errors.New("owner unavailable"))
	}
	if r.Owner == user.User.Sid.String() {
		return phase("owner-sid-matches-service", errors.New("service owns relay directory"))
	}
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return phase("admin-sid", err)
	}
	admin, err := windows.Token(0).IsMember(adminSID)
	if err != nil {
		return phase("admin-membership", err)
	}
	if admin {
		return phase("admin-member", errors.New("service token is administrator"))
	}
	return nil
}

func execute(stage string, r request) (result error) {
	stageName := "owner-info"
	defer func() { result = phase(stageName, result) }()
	sd, err := windows.GetNamedSecurityInfo(r.Directory, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return errors.New("cannot inspect relay directory owner")
	}
	stageName = "stage-executable"
	r.Owner = owner.String()
	src, err := os.Executable()
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	exe := filepath.Join(stage, "probe.exe")
	out, err := os.OpenFile(exe, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	arg, err := json.Marshal(r)
	if err != nil {
		return err
	}
	stageName = "scm-connect"
	name := "BrainTrailProof-" + r.Nonce
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	stageName = "scm-create"
	service, err := m.CreateService(name, exe, mgr.Config{StartType: mgr.StartManual, ServiceStartName: `NT AUTHORITY\LocalService`}, "--hosted-service", name, string(arg), filepath.Join(stage, "report.json"))
	if err != nil {
		return err
	}
	defer func() {
		_, stopErr := service.Control(svc.Stop)
		if stopErr != nil && !errors.Is(stopErr, windows.ERROR_SERVICE_NOT_ACTIVE) && result == nil {
			result = phase("scm-stop", stopErr)
		}
		deadline := time.Now().Add(10 * time.Second)
		stopped := false
		for time.Now().Before(deadline) {
			status, e := service.Query()
			if e != nil {
				if result == nil {
					result = phase("scm-query", e)
				}
				break
			}
			if status.State == svc.Stopped {
				stopped = true
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !stopped && result == nil {
			result = phase("scm-stop-timeout", errors.New("service did not stop"))
		}
		if e := service.Delete(); e != nil && result == nil {
			result = phase("scm-delete", e)
		}
		if e := service.Close(); e != nil && result == nil {
			result = phase("scm-close", e)
		}
	}()
	stageName = "scm-start"
	if err = service.Start(); err != nil {
		return fmt.Errorf("start LocalService: %w", err)
	}
	stageName = "service-report"
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		data, e := os.ReadFile(filepath.Join(stage, "report.json"))
		if e == nil {
			var answer report
			if len(data) > 4096 || json.Unmarshal(data, &answer) != nil {
				return errors.New("invalid service report")
			}
			if !answer.OK {
				if !safeRemote(answer.Error) {
					return errors.New("invalid service diagnostic")
				}
				return &remoteDiagnostic{value: answer.Error}
			}
			return nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		status, queryErr := service.Query()
		if queryErr != nil {
			return phase("scm-query", queryErr)
		}
		if status.State == svc.Stopped {
			code := status.Win32ExitCode
			if status.ServiceSpecificExitCode != 0 {
				code = status.ServiceSpecificExitCode
			}
			return phase("service-exited", syscall.Errno(code))
		}
		time.Sleep(100 * time.Millisecond)
	}
	return phase("timeout", errors.New("LocalService report timed out"))
}

type proofService struct {
	request    request
	reportPath string
}

func (p *proofService) Execute(_ []string, commands <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	statuses <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	done := make(chan uint32, 1)
	go func() {
		err := probe(p.request)
		answer := report{OK: err == nil}
		if err != nil {
			answer.Error = diagnostic(err)
		}
		data, e := json.Marshal(answer)
		if e != nil {
			done <- 1001
			return
		}
		tmp := p.reportPath + ".tmp"
		if e = os.WriteFile(tmp, data, 0600); e != nil {
			done <- 1002
			return
		}
		if e = os.Rename(tmp, p.reportPath); e != nil {
			done <- 1003
			return
		}
		done <- 0
	}()
	for {
		select {
		case code := <-done:
			if code != 0 {
				statuses <- svc.Status{State: svc.StopPending}
				return true, code
			}
			done = nil
		case c := <-commands:
			if c.Cmd == svc.Stop || c.Cmd == svc.Shutdown {
				statuses <- svc.Status{State: svc.StopPending}
				return false, 0
			}
			if c.Cmd == svc.Interrogate {
				statuses <- c.CurrentStatus
			}
		}
	}
}
func serviceEntry() bool {
	if len(os.Args) != 5 || os.Args[1] != "--hosted-service" {
		return false
	}
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		os.Exit(1)
	}
	var r request
	if json.Unmarshal([]byte(os.Args[3]), &r) != nil {
		os.Exit(1)
	}
	if err = svc.Run(os.Args[2], &proofService{request: r, reportPath: os.Args[4]}); err != nil {
		os.Exit(1)
	}
	return true
}
