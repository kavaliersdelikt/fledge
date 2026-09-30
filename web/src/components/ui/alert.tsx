import * as React from "react";
import { cn } from "@/lib/utils";

function Alert({ className, role = "status", ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role={role}
      data-slot="alert"
      className={cn("ui-alert", className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("ui-alert-title", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("ui-alert-description", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle };
