import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import "./FormControls.css";

export type SelectControlProps = SelectHTMLAttributes<HTMLSelectElement> & {
  containerClassName?: string;
  density?: "default" | "compact";
};

type TextControlAppearance = "default" | "borderless" | "inverse";
type TextControlDensity = "default" | "compact";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  appearance?: TextControlAppearance;
  density?: TextControlDensity;
};

export type TextAreaControlProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  appearance?: TextControlAppearance;
  density?: TextControlDensity;
};

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export const TextInput = forwardRef<
  HTMLInputElement,
  TextInputProps
>(({ appearance = "default", className, density = "default", ...props }, ref) => (
  <input
    {...props}
    ref={ref}
    className={joinClassNames(
      "text-input-control",
      appearance !== "default" ? `text-control-${appearance}` : undefined,
      density === "compact" ? "text-control-compact" : undefined,
      className,
    )}
  />
));

TextInput.displayName = "TextInput";

export const TextAreaControl = forwardRef<
  HTMLTextAreaElement,
  TextAreaControlProps
>(({ appearance = "default", className, density = "default", ...props }, ref) => (
  <textarea
    {...props}
    ref={ref}
    className={joinClassNames(
      "text-area-control",
      appearance !== "default" ? `text-control-${appearance}` : undefined,
      density === "compact" ? "text-control-compact" : undefined,
      className,
    )}
  />
));

TextAreaControl.displayName = "TextAreaControl";

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
