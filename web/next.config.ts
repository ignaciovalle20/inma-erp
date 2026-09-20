import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Server Actions are capped at 1 MB by default. The Nubox import sends
      // the parsed rows back to confirm (about 390 bytes per row, so the
      // default breaks at ~2,700 rows) and the file itself goes up in a
      // form. 4 MB fits the importer's own limits (3 MB file, 5,000 rows) and
      // stays under the 4.5 MB request body Vercel functions accept.
      bodySizeLimit: "4mb",
    },
  },
};

export default nextConfig;
