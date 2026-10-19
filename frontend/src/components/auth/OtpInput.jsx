import { useEffect, useRef } from "react";
export default function OtpInput({
    value,
    onChange,
}) {
    const inputs = useRef([]);
    useEffect(() => {
        inputs.current[0]?.focus();
    }, []);
    const handleChange = (index, event) => {
        const digit = event.target.value
            .replace(/\D/g, "")
            .slice(-1);
        const next = [...value];
        next[index] = digit;
        onChange(next);
        if (digit && index < 5) {
            inputs.current[index + 1]?.focus();
        }
    };
    const handleKeyDown = (index, event) => {
        if (
            event.key === "Backspace" &&
            !value[index] &&
            index > 0
        ) {
            inputs.current[index - 1]?.focus();
        }
    };
    const handlePaste = (event) => {
        event.preventDefault();
        const pasted = event.clipboardData
            .getData("text")
            .replace(/\D/g, "")
            .slice(0, 6);
        const next = Array(6).fill("");
        pasted.split("").forEach(
            (digit, index) => {
                next[index] = digit;
            }
        );
        onChange(next);
        inputs.current[
            Math.min(pasted.length, 5)
        ]?.focus();
    };
    return (
        <div
            className="flex justify-between gap-2"
            onPaste={handlePaste}
        >
            {Array.from({ length: 6 }).map(
                (_, index) => (
                    <input
                        key={index}
                        ref={(element) => {
                            inputs.current[index] =
                                element;
                        }}
                        value={value[index] || ""}
                        onChange={(event) =>
                            handleChange(
                                index,
                                event
                            )
                        }
                        onKeyDown={(event) =>
                            handleKeyDown(
                                index,
                                event
                            )
                        }
                        inputMode="numeric"
                        maxLength={1}
                        className="h-14 w-12 rounded-xl border border-slate-200 bg-white text-center text-xl font-bold text-slate-900 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100 sm:h-16 sm:w-14"
                    />
                )
            )}
        </div>
    );
}