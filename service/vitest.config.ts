// Kept separate from any build config on purpose, mirroring sms_sr: a plain
// object, no defineConfig import, so the test runner never depends on the
// bundler toolchain.
export default {
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "scripts/**/__tests__/**/*.test.ts"],
    // Tests that talk to the real Foundry stack are opt-in via
    // RUN_FOUNDRY_INTEGRATION=1 and self-skip otherwise.
  },
};
