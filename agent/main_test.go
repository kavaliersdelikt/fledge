package main

import (
	"os"
	"testing"
)

func TestConsumeEnrollmentTokenClearsEnvironment(t *testing.T) {
	const secret = "one-time-enrollment-token"
	t.Setenv("ENROLLMENT_TOKEN", secret)
	if got := consumeEnrollmentToken(); got != secret {
		t.Fatalf("consumeEnrollmentToken() = %q, want supplied token", got)
	}
	if _, ok := os.LookupEnv("ENROLLMENT_TOKEN"); ok {
		t.Fatal("one-time enrollment token remains in the agent process environment")
	}
}
