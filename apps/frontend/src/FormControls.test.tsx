import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SelectControl } from "./FormControls";

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
