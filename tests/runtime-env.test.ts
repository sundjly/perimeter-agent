import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openEnvironment } from "../src/runtime/execution-env.ts";

test("pi-env：真实 daemon 复用一条连接完成文件与进程操作", async () => {
	const dir = mkdtempSync(join(tmpdir(), "env-"));
	const executable = join(process.cwd(), "node_modules/@earendil-works/pi-env/bin", `pi-env-${process.platform}-${process.arch}`, "pi-env");
	const handle = await openEnvironment({ cwd: dir, command: [executable] });
	try {
		const write = await handle.env.writeFile("a.txt", "hello", BACKGROUND_CONTEXT);
		assert.equal(write.ok, true);
		const read = await handle.env.readTextFile("a.txt", BACKGROUND_CONTEXT);
		assert.deepEqual(read, { ok: true, value: "hello" });
		const result = await handle.env.exec("cat a.txt", undefined, BACKGROUND_CONTEXT);
		assert.equal(result.ok, true);
	} finally {
		try { await handle.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
	}
});
