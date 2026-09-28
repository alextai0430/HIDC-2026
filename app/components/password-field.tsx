"use client";

import { useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function PasswordField(props: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <span className="password-field">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        className="password-visibility-toggle"
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <Eye size={17} aria-hidden="true" /> : <EyeOff size={17} aria-hidden="true" />}
      </button>
    </span>
  );
}
