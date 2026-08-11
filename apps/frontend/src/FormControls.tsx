import { ChevronDown } from "lucide-react";
import { forwardRef, type SelectHTMLAttributes } from "react";

import "./FormControls.css";

export type SelectControlProps = SelectHTMLAttributes<HTMLSelectElement> & {
  containerClassName?: string;
  density?: "default" | "compact";
};

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(
  ({ children, className, containerClassName, density = "default", disabled, ...props }, ref) => (
    <span
      className={joinClassNames(
        "select-control",
        density === "compact" ? "select-control-compact" : undefined,
        containerClassName,
      )}
      data-disabled={disabled || undefined}
    >
      <select
        {...props}
        ref={ref}
        className={joinClassNames("select-control-input", className)}
        disabled={disabled}
      >
        {children}
      </select>
      <ChevronDown className="select-control-icon" size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  ),
);

SelectControl.displayName = "SelectControl";
