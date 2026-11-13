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
		return err
	}
	if user.User.Sid.String() != "S-1-5-19" || r.Owner == "" || r.Owner == user.User.Sid.String() {
		return errors.New("service identity is not distinct LocalService")
	}
	adminSID, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	admin, err := windows.Token(0).IsMember(adminSID)
	if err != nil {
		return err
	}
	if admin {
		return errors.New("LocalService token is an administrator")
	}
	return nil
}

func execute(stage string, r request) (result error) {
	sd, err := windows.GetNamedSecurityInfo(r.Directory, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return errors.New("cannot inspect relay directory owner")
	}
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
	name := "BrainTrailProof-" + r.Nonce
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	service, err := m.CreateService(name, exe, mgr.Config{StartType: mgr.StartManual, ServiceStartName: `NT AUTHORITY\LocalService`}, "--hosted-service", name, string(arg), filepath.Join(stage, "report.json"))
	if err != nil {
		return err
	}
	defer func() {
		_, stopErr := service.Control(svc.Stop)
		if stopErr != nil && !errors.Is(stopErr, windows.ERROR_SERVICE_NOT_ACTIVE) && result == nil {
			result = fmt.Errorf("stop service: %w", stopErr)
		}
		deadline := time.Now().Add(10 * time.Second)
		stopped := false
		for time.Now().Before(deadline) {
			status, e := service.Query()
			if e != nil {
				if result == nil {
					result = fmt.Errorf("query service: %w", e)
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
			result = errors.New("service did not stop before cleanup deadline")
		}
		if e := service.Delete(); e != nil && result == nil {
			result = fmt.Errorf("delete service: %w", e)
		}
		if e := service.Close(); e != nil && result == nil {
			result = e
		}
	}()
	if err = service.Start(); err != nil {
		return fmt.Errorf("start LocalService: %w", err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		data, e := os.ReadFile(filepath.Join(stage, "report.json"))
		if e == nil {
			var answer report
			if len(data) > 4096 || json.Unmarshal(data, &answer) != nil || !answer.OK {
				return fmt.Errorf("other-account probe failed: %s", answer.Error)
			}
			return nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return e
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("LocalService report timed out")
}

type proofService struct {
	request    request
	reportPath string
}

func (p *proofService) Execute(_ []string, commands <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	statuses <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	done := make(chan struct{})
	go func() {
		err := probe(p.request)
		answer := report{OK: err == nil}
		if err != nil {
			answer.Error = err.Error()
		}
		data, e := json.Marshal(answer)
		if e == nil {
			tmp := p.reportPath + ".tmp"
			if os.WriteFile(tmp, data, 0600) == nil {
				_ = os.Rename(tmp, p.reportPath)
			}
		}
		close(done)
	}()
	for {
		select {
		case <-done:
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
