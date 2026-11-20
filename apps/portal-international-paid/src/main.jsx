import { mountPortal } from "@pp/web-core/mount";
import deployment from "./deployment.config.js";

mountPortal({ target: "international-paid", deployment });
