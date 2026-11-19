import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { ApiError, type Api } from "../src/api/client";
import LoginScreen from "../src/screens/LoginScreen";
import TripsScreen from "../src/screens/TripsScreen";

const user = { email: "lead@example.com", firstName: "Tara", lastName: "Lead", role: "Team Leader" };
const fakeApi = (over: Partial<Api>) => ({ login: jest.fn(), trips: jest.fn(async () => []), ...over }) as unknown as Api;

// react-native loads its components lazily, so the first render in a worker pays for
// loading and transforming them (seconds when the Jest cache is cold). Pay it here, not
// inside whichever test happens to run first and hit the 5s per-test timeout.
beforeAll(() => {
  render(<LoginScreen api={fakeApi({})} onSignedIn={jest.fn()} />).unmount();
}, 120_000);

describe("sign in screen", () => {
  it("signs in with what was typed and hands over the user", async () => {
    const api = fakeApi({ login: jest.fn(async () => user) });
    const onSignedIn = jest.fn();
    render(<LoginScreen api={api} onSignedIn={onSignedIn} />);
    fireEvent.changeText(screen.getByLabelText("Email address"), "lead@example.com");
    fireEvent.changeText(screen.getByLabelText("Password"), "secret-pass");
    fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(user));
    expect(api.login).toHaveBeenCalledWith("lead@example.com", "secret-pass");
  });
  it("a wrong password says so plainly and clears the password field", async () => {
    const api = fakeApi({ login: jest.fn(async () => { throw new ApiError("INVALID_CREDENTIALS", 401); }) });
    render(<LoginScreen api={api} onSignedIn={jest.fn()} />);
    fireEvent.changeText(screen.getByLabelText("Email address"), "lead@example.com");
    fireEvent.changeText(screen.getByLabelText("Password"), "nope");
    fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The email or password is incorrect.")).toBeTruthy();
    expect(screen.getByLabelText("Password").props.value).toBe("");
  });
});

describe("sign in screen while busy", () => {
  it("asks for both fields without calling the API", () => {
    const api = fakeApi({});
    render(<LoginScreen api={api} onSignedIn={jest.fn()} />);
    fireEvent.changeText(screen.getByLabelText("Email address"), "lead@example.com");
    fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your email address and password.")).toBeTruthy();
    expect(api.login).not.toHaveBeenCalled();
  });
  it("sends only one request while sign-in is in flight, then hands over the user", async () => {
    let finish: (u: typeof user) => void = () => {};
    const api = fakeApi({ login: jest.fn(() => new Promise<typeof user>((resolve) => { finish = resolve; })) });
    const onSignedIn = jest.fn();
    render(<LoginScreen api={api} onSignedIn={onSignedIn} />);
    fireEvent.changeText(screen.getByLabelText("Email address"), "lead@example.com");
    fireEvent.changeText(screen.getByLabelText("Password"), "secret-pass");
    fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.press(screen.getByRole("button"));
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(onSignedIn).not.toHaveBeenCalled();
    await act(async () => finish(user));
    expect(onSignedIn).toHaveBeenCalledWith(user);
    expect(screen.getByLabelText("Password").props.value).toBe("");
  });
});

describe("my trips", () => {
  it("with no assigned trip, explains that staff must choose them (registering as Team Leader isn't enough)", async () => {
    render(<TripsScreen api={fakeApi({})} user={user} onOpen={jest.fn()} onSignOut={jest.fn()} onSessionEnded={jest.fn()} />);
    expect(await screen.findByText("No trips yet")).toBeTruthy();
    expect(screen.getByText(/Registering as a Team Leader is not enough/)).toBeTruthy();
  });
  it("an ended sign-in sends the user back to sign in", async () => {
    const onSessionEnded = jest.fn();
    render(<TripsScreen api={fakeApi({ trips: jest.fn(async () => { throw new ApiError("UNAUTHENTICATED", 401); }) })} user={user} onOpen={jest.fn()} onSignOut={jest.fn()} onSessionEnded={onSessionEnded} />);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });
});
