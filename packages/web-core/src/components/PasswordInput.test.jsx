import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import PasswordInput from "./PasswordInput.jsx";

function Harness({ onSubmit = () => {} }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ a, b }); }}>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" value={a} onChange={(e) => setA(e.target.value)} autoComplete="new-password" />
      <label htmlFor="pw2">Confirm password</label>
      <PasswordInput id="pw2" value={b} onChange={(e) => setB(e.target.value)} autoComplete="new-password" toggleLabel="confirm password" />
      <button type="submit">Save</button>
    </form>
  );
}

describe("PasswordInput: show / hide", () => {
  it("is masked by default, with an accessible Show button that controls the field", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-controls", "pw");
  });

  it("reveals and hides again, keeping the value and the autocomplete hint", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText("Password");
    await user.type(field, "s3cret-Pass!");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(field).toHaveAttribute("type", "text");
    expect(field).toHaveValue("s3cret-Pass!");
    expect(field).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveValue("s3cret-Pass!");
  });

  it("each field has its own independent toggle", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Show confirm password" }));
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeInTheDocument();
  });

  it("works from the keyboard (Tab to it, Enter and Space toggle) and never submits the form", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const field = screen.getByLabelText("Password");
    await user.click(field);
    await user.tab();
    expect(screen.getByRole("button", { name: "Show password" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(field).toHaveAttribute("type", "text");
    await user.keyboard(" ");
    expect(field).toHaveAttribute("type", "password");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the caret where it was when toggled", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText("Password");
    await user.type(field, "abcdef");
    field.setSelectionRange(2, 2);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(2);
  });

  it("the form submits the typed values whether the field is shown or hidden", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Password"), "first-value-1");
    await user.type(screen.getByLabelText("Confirm password"), "second-value-2");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ a: "first-value-1", b: "second-value-2" });
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenLastCalledWith({ a: "first-value-1", b: "second-value-2" });
  });

  it("the toggle's label never contains the password", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Password"), "hunter2-secret");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    for (const b of screen.getAllByRole("button")) expect(b.getAttribute("aria-label") ?? "").not.toContain("hunter2");
  });
});

describe("every password field in the app uses PasswordInput", () => {
  it("no screen renders a bare type=\"password\" input", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const { cwd } = await import("node:process");
    const root = resolve(cwd(), "src");
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.jsx$/.test(name) && !/\.test\.jsx$/.test(name) && name !== "PasswordInput.jsx") files.push(p);
      }
    };
    walk(root);
    const offenders = files.filter((f) => /type=["']password["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    expect(files.filter((f) => readFileSync(f, "utf8").includes("<PasswordInput")).length).toBeGreaterThanOrEqual(5);
  });
});
