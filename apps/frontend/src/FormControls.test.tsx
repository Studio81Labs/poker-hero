import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SelectControl, TextAreaControl, TextInput } from "./FormControls";

describe("text controls", () => {
  it("forwards native input properties and custom classes", () => {
    render(
      <TextInput
        aria-label="Pot size"
        appearance="borderless"
        className="pot-input"
        defaultValue="12.5"
        density="compact"
        inputMode="decimal"
        disabled
      />,
    );

    const input = screen.getByRole("textbox", { name: "Pot size" });
    expect(input).toHaveValue("12.5");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).toHaveClass(
      "text-input-control",
      "text-control-borderless",
      "text-control-compact",
      "pot-input",
    );
  });

  it("forwards native textarea behavior and custom classes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <TextAreaControl
        aria-label="Lesson note"
        appearance="inverse"
        className="lesson-note"
        maxLength={24}
        onChange={onChange}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "Lesson note" });
    expect(textarea).toHaveClass(
      "text-area-control",
      "text-control-inverse",
      "lesson-note",
    );
    expect(textarea).toHaveAttribute("maxlength", "24");

    await user.type(textarea, "Review river sizing");

    expect(textarea).toHaveValue("Review river sizing");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("SelectControl", () => {
  it("preserves native select behavior and applies shared styling", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <SelectControl aria-label="Street" defaultValue="flop" onChange={onChange}>
        <option value="flop">Flop</option>
        <option value="turn">Turn</option>
      </SelectControl>,
    );

    const select = screen.getByRole("combobox", { name: "Street" });
    expect(select).toHaveClass("select-control-input");

    await user.selectOptions(select, "turn");

    expect(select).toHaveValue("turn");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("forwards disabled state and custom classes", () => {
    render(
      <SelectControl
        aria-label="Provider"
        className="provider-select"
        containerClassName="provider-control"
        density="compact"
        disabled
      >
        <option>Local solver</option>
      </SelectControl>,
    );

    const select = screen.getByRole("combobox", { name: "Provider" });
    expect(select).toBeDisabled();
    expect(select).toHaveClass("select-control-input", "provider-select");
    expect(select.parentElement).toHaveClass("select-control", "provider-control");
    expect(select.parentElement).toHaveClass("select-control-compact");
    expect(select.parentElement).toHaveAttribute("data-disabled", "true");
  });
});
