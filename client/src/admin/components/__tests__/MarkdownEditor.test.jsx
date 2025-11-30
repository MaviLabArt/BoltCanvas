import React from "react";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import MarkdownEditor from "../MarkdownEditor.jsx";

describe("MarkdownEditor", () => {
  it("renders value and applies bold formatting", async () => {
    const handleChange = vi.fn();
    await act(async () => {
      render(<MarkdownEditor value="text" onChange={handleChange} />);
    });

    const textarea = screen.getByRole("textbox");
    expect(textarea.value).toBe("text");

    await act(async () => {
      fireEvent.click(screen.getByText("B"));
    });
    expect(handleChange).toHaveBeenCalled();
  });
});
