import { Globe2 } from "lucide-react";
export default function SocialLoginButton({
    provider,
    onClick,
}) {
    const isGoogle = provider === "google";
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 active:scale-[0.99]"
        >
            {isGoogle ? (
                <Globe2
                    size={19}
                    className="text-slate-700"
                />
            ) : (
                <svg
                    width="18"
                    height="18"
                    viewBox="0 0 23 23"
                    aria-hidden="true"
                >
                    <rect
                        x="1"
                        y="1"
                        width="10"
                        height="10"
                        fill="#f25022"
                    />
                    <rect
                        x="12"
                        y="1"
                        width="10"
                        height="10"
                        fill="#7fba00"
                    />
                    <rect
                        x="1"
                        y="12"
                        width="10"
                        height="10"
                        fill="#00a4ef"
                    />
                    <rect
                        x="12"
                        y="12"
                        width="10"
                        height="10"
                        fill="#ffb900"
                    />
                </svg>
            )}
            Continue with {isGoogle ? "Google" : "Microsoft"}
        </button>
    );
}