//go:build !windows

package main

func privacyTestDiagnostic(_, _ string) string { return "Windows ACL diagnostics unavailable" }
