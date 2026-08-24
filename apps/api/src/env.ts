export interface AppEnv {
  Bindings: {
    DATABASE_URL: string;
    /** Set to "1" to disable the development auth endpoint. */
    DISABLE_DEV_AUTH?: string;
  };
  Variables: {
    userId: string;
    deviceId: string;
  };
}
