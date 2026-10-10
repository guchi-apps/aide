import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getProcessInfo } from "../../core/process-info.ts";
import { readPackageVersion } from "../../core/version.ts";
import { pingTool } from "./ping.ts";

describe("aide_ping", () => {
  it("従来の項目に加えて serverVersion と startedAt を返す", async () => {
    const res = await pingTool.handler({}, { sessionId: "s1" });
    const text = res.content[0]!.text;
    assert.match(text, /^pong \/ time=.+ \/ session=s1 /);
    assert.ok(text.includes(`serverVersion=${readPackageVersion()}`));
    assert.ok(text.includes(`startedAt=${getProcessInfo().startedAt}`));
    assert.match(getProcessInfo().startedAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  });

  it("繰り返し呼んでも startedAt は変わらない", async () => {
    const a = getProcessInfo().startedAt;
    await pingTool.handler({}, { sessionId: null });
    assert.equal(getProcessInfo().startedAt, a);
  });
});
