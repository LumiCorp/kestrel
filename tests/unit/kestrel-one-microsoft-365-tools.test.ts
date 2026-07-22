import assert from "node:assert/strict";

import {
  kestrelOneMicrosoft365ListMailTool,
  kestrelOneMicrosoft365SendMailTool,
} from "../../tools/kestrelOne/microsoft-365.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "Microsoft 365 tools carry confirmed Project approval to the App route",
  async () => {
    const requests: Headers[] = [];
    const context = {
      kestrelOne: {
        appUrl: "https://kestrel.example",
        executionTicket: "signed-environment-ticket",
        appApprovalModes: {
          "kestrel_one.microsoft_365_list_mail": "ask" as const,
          "kestrel_one.microsoft_365_send_mail": "ask" as const,
        },
      },
      fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Headers(init?.headers));
        return Response.json({ result: { ok: true } });
      },
    };

    await kestrelOneMicrosoft365ListMailTool.createHandler(context)({
      maxResults: 1,
    });
    await kestrelOneMicrosoft365SendMailTool.createHandler(context)({
      to: ["person@example.com"],
      subject: "Decision",
      body: "Approved.",
    });

    assert.equal(
      requests[0]?.get("x-kestrel-runtime-approval"),
      "confirmed",
    );
    assert.equal(
      requests[1]?.get("x-kestrel-runtime-approval"),
      "confirmed",
    );
  },
);
