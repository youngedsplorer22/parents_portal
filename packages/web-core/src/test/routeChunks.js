// AppRoutes loads each screen with React.lazy(() => import(...)). In a test, the first import() of a chunk is a cold
// module load: StaffApp alone takes about a second on a quiet machine, and much longer when test files run in parallel.
// That cost used to be paid inside the first findBy* of a test, whose own budget is Testing Library's default 1 second, so
// the first test of a file that needed a chunk failed on a busy machine (an empty page while the chunk was loading, or a
// page stuck on "Opening the registration page…" because the chunk arrived at the last moment).
//
// Loading the chunks once in beforeAll, outside any assertion, makes that cost irrelevant to the test. The tests keep
// their 1 second waits: they now measure the page, not the module loader. Use it in every test file that renders AppRoutes:
//   beforeAll(preloadRouteChunks, 60_000);
// (the hook's own limit only guards against a real hang; a failed import fails the hook loudly).
export function preloadRouteChunks() {
  return Promise.all([
    import("../admin/StaffApp.jsx"),
    import("../App.jsx"),
    import("../join/JoinPage.jsx"),
    import("../join/JoinContinue.jsx"),
    import("../join/RetiredLink.jsx"),
  ]);
}
