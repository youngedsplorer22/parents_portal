// The ONE school and trip this portal is prepared for. The developer edits this file for each school, builds, and redeploys.
// Full steps: DEPLOYMENT.md, "Preparing a portal for a school".
//
//   school, branch, trip   the trip's address words in the database: the last three parts of its registration link
//                          /join/<school>/<branch>/<trip> (npm run ops -- trip:config prints them). A school with no
//                          branch uses "main". Lowercase letters, digits and single hyphens only.
//   schoolName, tripTitle  what parents see on the registration page (keep them the same as the database record)
//   destination            optional
//   logo                   optional, this deployment's own logo. You normally leave it null and use schoolLogos below.
//   schoolLogos            the logo of EVERY school this portal has served, kept in the repository (never in the database).
//                          Put the file in src/school-logos/<school>-<branch>.png, import it, and add
//                              "<school>/<branch>": thatImport
//                          Never remove an old school's entry: it is how that school's earlier participants keep seeing their
//                          own logo after this portal is customised for another school. The new school's logo is only ever
//                          shown for the new school's own registrations.
//
// Left empty, the portal shows "This registration portal isn't set up yet" and takes no registrations. The server separately
// accepts new registrations here only for the trip bound to this template (portal_deployments), so the old school's link
// stops working as soon as the previous trip is closed, even before this site is redeployed.
// import abcJaipurLogo from "./school-logos/abc-school-jaipur.png";

// Staging test configuration (dummy data only). Comment-only edit made to trigger a fresh staging deployment.

export default {
  school: "staging-demo-school",
  branch: "noida",
  trip: "domestic-paid-staging-test-2027",
  schoolName: "Staging Demo School",
  tripTitle: "Domestic Paid Staging Test 2027",
  destination: "Jaipur",
  logo: null,
  schoolLogos: {
    // "abc-school/jaipur": abcJaipurLogo,
  },
};
