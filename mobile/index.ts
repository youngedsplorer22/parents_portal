// The background location task must be registered before anything else runs, so it exists even when Android starts
// the app without a screen to deliver locations.
import "./src/location/registerTask";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
