"use client";
import { useEffect, useState } from "react";
import { Modal } from "./feedback";
import { Form, Field } from "./shared";
export default function StepUpPrompt() {
  const [pending, setPending] = useState<((s: string | null) => void) | null>(
    null,
  );
  useEffect(() => {
    const listener = (event: Event) => {
      const answer = (event as CustomEvent).detail as (
        s: string | null,
      ) => void;
      setPending((old: ((s: string | null) => void) | null) => {
        if (old) old(null);
        return answer;
      });
    };
    window.addEventListener("fledge:step-up", listener);
    return () => window.removeEventListener("fledge:step-up", listener);
  }, []);
  return (
    <Modal
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) {
          pending?.(null);
          setPending(null);
        }
      }}
      title="Confirm it’s you"
      description="This action needs a fresh authenticator code."
    >
      <Form
        submit="Continue"
        onSubmit={async (form) => {
          pending?.(String(form.totp));
          setPending(null);
        }}
      >
        <Field
          label="Authenticator code"
          name="totp"
          required
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
        />
      </Form>
    </Modal>
  );
}
