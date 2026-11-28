import { checkUrl } from "../src/url";

describe("RootCause addresses", () => {
  it("release builds need https", () => {
    expect(checkUrl("https://app.rootcauseobd.com.au/x", false)).toBe("https://app.rootcauseobd.com.au");
    expect(() => checkUrl("http://127.0.0.1:3000", false)).toThrow(/https/);
    expect(() => checkUrl("http://app.example.com", true)).toThrow(/https/);
  });
  it("dev builds may use this machine over http", () => {
    expect(checkUrl("http://127.0.0.1:3000", true)).toBe("http://127.0.0.1:3000");
    expect(checkUrl("http://10.0.2.2:8000", true)).toBe("http://10.0.2.2:8000");
  });
});
