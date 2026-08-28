import { readFile } from "node:fs/promises";

const app = JSON.parse(await readFile(new URL("../app.json", import.meta.url), "utf8"));
const googleServices = JSON.parse(
  await readFile(new URL("../google-services.json", import.meta.url), "utf8"),
);
const expected = app.expo.android.package;
const actual = googleServices.client?.[0]?.client_info?.android_client_info?.package_name;

if (actual !== expected) {
  console.error(
    `Android identity mismatch: app=${expected}, google-services=${actual ?? "missing"}. ` +
      "Download a new Firebase google-services.json before Android release acceptance.",
  );
  process.exitCode = 1;
} else {
  console.log(`Android identity verified: ${expected}`);
}
