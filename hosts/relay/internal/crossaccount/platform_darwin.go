//go:build darwin

package main

import (
	"errors"
	"syscall"
)

// Darwin supports the transport controls, but does not claim cross-account proof.
func serviceEntry() bool            { return false }
func managerGuard() error           { return errors.New("cross-account proof unsupported on Darwin") }
func prepareStage(string) error     { return managerGuard() }
func prepareSocket(string) error    { return managerGuard() }
func verifyIdentity(request) error  { return managerGuard() }
func execute(string, request) error { return managerGuard() }
func isPermission(err error) bool {
	return errors.Is(err, syscall.EACCES) || errors.Is(err, syscall.EPERM)
}
func isClosed(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}
