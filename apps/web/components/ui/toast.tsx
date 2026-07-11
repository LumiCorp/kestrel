"use client";

import type * as React from "react";

export type ToastProps = {
  id?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export type ToastActionElement = React.ReactElement;

// Minimal toast component for compatibility
// This project uses sonner for toasts, but this component exists for type compatibility
export function Toast(_props: ToastProps) {
  return null;
}
