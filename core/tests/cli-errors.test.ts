import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  classifyError,
} from "../../tooling/weflowctl/src/cli-errors.js";

describe("cli error registry", () => {
  it("exposes stable error code strings", () => {
    expect(ErrorCodes.SignatureInvalid).toBe("solution_signature_invalid");
    expect(ErrorCodes.UpdateStrategyInvalid).toBe("invalid_update_strategy");
    expect(ErrorCodes.RegistryUnreachable).toBe("registry_unreachable");
    expect(ErrorCodes.StoreLocked).toBe("store_locked");
  });

  it("classifies infrastructure error messages by stable prefix", () => {
    const classified = classifyError("solution_signature_invalid");
    expect(classified.code).toBe("solution_signature_invalid");
    expect(classified.hint).toBeTruthy();
  });

  it("classifies parameterised messages that embed the prefix", () => {
    expect(
      classifyError("invalid_update_strategy:weekly:expected manual|patch")
        .code,
    ).toBe("invalid_update_strategy");
    expect(
      classifyError("registry_version_not_found:weflow.demo:9.9.9").code,
    ).toBe("registry_version_not_found");
    expect(
      classifyError("solution_version_not_in_store:weflow.demo:2.0.0:hint")
        .code,
    ).toBe("solution_version_not_in_store");
  });

  it("maps network failures to registry_unreachable", () => {
    expect(classifyError("fetch failed").code).toBe("registry_unreachable");
    expect(classifyError("getaddrinfo ENOTFOUND registry.test").code).toBe(
      "registry_unreachable",
    );
  });

  it("returns a generic code with no hint for unknown messages", () => {
    const classified = classifyError("something exploded");
    expect(classified.code).toBe(ErrorCodes.Internal);
    expect(classified.hint).toBeUndefined();
  });
});
