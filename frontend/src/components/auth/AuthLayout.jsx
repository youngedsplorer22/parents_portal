import { ShieldCheck } from "lucide-react";

export default function AuthLayout({
    children,
    title,
    subtitle,
}) {
    return (
        <div className="min-h-screen bg-slate-50">
            <div className="grid min-h-screen lg:grid-cols-2">

                {/* =========================
                    BRANDING SIDE
                ========================== */}
                <div className="relative hidden overflow-hidden bg-slate-900 lg:flex">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(59,130,246,0.25),_transparent_45%)]" />
                    <div className="relative flex w-full flex-col justify-between p-12 xl:p-16">
                        <div className="brand">
                            <img
                                src="/logo.png"
                                alt="Young Edsplorer"
                                className="brand-logo"
                            />
                        </div>
                        <div className="max-w-lg">
                            <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-blue-400">
                                Secure Parent Portal
                            </p>
                            <h1 className="text-4xl font-bold leading-tight text-white xl:text-5xl">
                                One simple place to manage your child's information.
                            </h1>
                            <p className="mt-6 text-base leading-7 text-slate-400">
                                Securely submit and manage your child's
                                information through the Young Edsplorer
                                parent portal.
                            </p>
                        </div>
                        <p className="text-sm text-slate-500">
                            © 2026 Young Edsplorer Pvt. Ltd.
                        </p>
                    </div>
                </div>
                {/* =========================
                    FORM SIDE
                ========================== */}
                <div className="flex items-center justify-center px-5 py-10 sm:px-8">
                    <div className="w-full max-w-md">
                        {/* Mobile brand */}
                        <div className="mb-8 lg:hidden">
                            <p className="text-xl font-bold text-slate-900">
                                Young Edsplorer
                            </p>
                            <p className="text-sm text-slate-500">
                                Parent Portal
                            </p>
                        </div>
                        <div className="mb-8">
                            <h2 className="text-3xl font-bold tracking-tight text-slate-900">
                                {title}
                            </h2>
                            <p className="mt-2 text-sm leading-6 text-slate-500">
                                {subtitle}
                            </p>
                        </div>
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}