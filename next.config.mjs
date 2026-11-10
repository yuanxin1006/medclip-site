/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  env: {
    NEXT_PUBLIC_MEDCLIP_ACCEPTANCE_INPUT_HYDRATION:
      process.env.NEXT_PUBLIC_MEDCLIP_ACCEPTANCE_INPUT_HYDRATION === "1" ? "1" : "0",
  },
  webpack(config, { dev }) {
    if (!dev) {
      // Transformers.js statically references its packaged ONNX WASM, so Webpack
      // emits a 21.6 MB duplicate even though the worker sets wasmPaths first.
      // Keep the module reference in the bundle but suppress file emission;
      // production ASR requires the explicit, hash-checked asset host.
      config.module.rules.push({
        test: /ort-wasm-simd-threaded\.jsep\.wasm$/,
        type: "asset/resource",
        generator: { emit: false },
      });
    }
    return config;
  },
  images: {
    unoptimized: true
  },
  poweredByHeader: false
};

export default nextConfig;


