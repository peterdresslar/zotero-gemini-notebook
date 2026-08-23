import { config } from "../package.json";
import hooks from "./hooks";
import { bridgeApi } from "./modules/bridgeJobs";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
  };
  public hooks: typeof hooks;
  public readonly api: typeof bridgeApi;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.api = bridgeApi;
  }
}

export default Addon;
