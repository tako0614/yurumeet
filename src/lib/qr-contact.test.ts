import { describe, expect, test } from "bun:test";
import { parseScannedContact } from "./qr-contact.ts";

const MY_ORIGIN = "https://yurume.example";
const MY_HOST = "yurume.example";

const parse = (text: string) => parseScannedContact(text, MY_HOST, MY_ORIGIN);

describe("parseScannedContact", () => {
  test("own-product QR: local profile URL with encoded AP id", () => {
    const apId = `${MY_ORIGIN}/ap/users/alice`;
    const qr = `${MY_ORIGIN}/profile/${encodeURIComponent(apId)}#alice`;
    expect(parse(qr)).toEqual({ kind: "local", apId });
  });

  test("yurucommu QR from another server resolves via embedded AP id", () => {
    const apId = "https://commu.example/ap/users/bob";
    const qr = `https://commu.example/profile/${encodeURIComponent(apId)}#bob`;
    expect(parse(qr)).toEqual({ kind: "remote", handle: "@bob@commu.example" });
  });

  test("remote profile URL without parsable AP id falls back to fragment", () => {
    const qr = "https://other.example/profile/opaque-id#carol";
    expect(parse(qr)).toEqual({
      kind: "remote",
      handle: "@carol@other.example",
    });
  });

  test("remote profile URL with neither AP id nor fragment is rejected", () => {
    expect(parse("https://other.example/profile/opaque-id")).toBeNull();
  });

  test("bare AP id (the user id itself) on this server", () => {
    expect(parse(`${MY_ORIGIN}/ap/users/alice`)).toEqual({
      kind: "local",
      apId: `${MY_ORIGIN}/ap/users/alice`,
    });
  });

  test("bare AP id on another server becomes a WebFinger handle", () => {
    expect(parse("https://commu.example/ap/users/bob")).toEqual({
      kind: "remote",
      handle: "@bob@commu.example",
    });
  });

  test("web /users/ profile route", () => {
    expect(parse(`${MY_ORIGIN}/users/alice`)).toEqual({
      kind: "local",
      apId: `${MY_ORIGIN}/ap/users/alice`,
    });
    expect(parse("https://commu.example/users/bob")).toEqual({
      kind: "remote",
      handle: "@bob@commu.example",
    });
  });

  test("typed handle with and without leading @", () => {
    expect(parse("@bob@commu.example")).toEqual({
      kind: "remote",
      handle: "@bob@commu.example",
    });
    expect(parse("bob@commu.example")).toEqual({
      kind: "remote",
      handle: "@bob@commu.example",
    });
  });

  test("handle on own host resolves locally without WebFinger", () => {
    expect(parse(`@alice@${MY_HOST}`)).toEqual({
      kind: "local",
      apId: `${MY_ORIGIN}/ap/users/alice`,
    });
  });

  test("non-contact payloads are rejected", () => {
    expect(parse("")).toBeNull();
    expect(parse("hello world")).toBeNull();
    expect(parse("https://example.com/some/other/page")).toBeNull();
    expect(parse("ftp://example.com/profile/x")).toBeNull();
    expect(parse("WIFI:S:mynet;T:WPA;P:pass;;")).toBeNull();
  });
});
