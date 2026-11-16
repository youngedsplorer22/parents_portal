import { Link2 } from "lucide-react";

const TITLE = "Open your school's trip registration link";

/** Signed in on the homepage with no registration yet: the trip comes only from the school's page, never guessed. */
export function NoTripYet() {
  return (
    <section className="resume-notice" aria-labelledby="no-trip-title">
      <Link2 className="resume-icon" size={26} aria-hidden="true" />
      <h1 id="no-trip-title">{TITLE}</h1>
      <p>
        You're signed in, but there's no trip registration on your account yet. To begin, open the trip registration link your school
        sent you. Your registration will be started for that trip.
      </p>
      <p className="resume-staff">
        This is the parent portal. If you work for Young Edsplorer, use the <a href="/sales/login">Sales log in</a> or <a href="/admin/login">Admin log in</a> instead.
      </p>
    </section>
  );
}

/**
 * Signed in on the homepage, and the account has more than one registration. Nothing is guessed, listed or changed:
 * the school's trip link decides which one opens (and resumes it, or shows it if submitted).
 */
export function SeveralRegistrations() {
  return (
    <section className="resume-notice" aria-labelledby="several-title">
      <Link2 className="resume-icon" size={26} aria-hidden="true" />
      <h1 id="several-title">{TITLE}</h1>
      <p>
        Your account has more than one trip registration. To continue, open the registration link your school sent for the trip you want.
        Your saved answers, or your submitted registration, will open from there.
      </p>
    </section>
  );
}
