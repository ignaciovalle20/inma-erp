import type { NextConfig } from "next";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const nextConfig: NextConfig = {
  // Servicios recurrentes moved from Configuración to Gestión: the service
  // catalog, its detail and create/edit pages now live under
  // /recurring-services/services, the old "Pendientes" is Deuda, and the
  // cost pools are Costos > Reparto licencias MS. Old links and bookmarks
  // land on the new pages (query strings are kept). Temporary (307) so a
  // future move isn't stuck in browser caches.
  async redirects() {
    const base = "/companies/:id/recurring-services";
    return [
      { source: `${base}/pending`, destination: `${base}/debt`, permanent: false },
      { source: `${base}/new`, destination: `${base}/services/new`, permanent: false },
      {
        source: `${base}/:serviceId(${UUID})/edit`,
        destination: `${base}/services/:serviceId/edit`,
        permanent: false,
      },
      {
        source: `${base}/:serviceId(${UUID})`,
        destination: `${base}/services/:serviceId`,
        permanent: false,
      },
      { source: `${base}/cost-pools`, destination: "/companies/:id/costs/ms-licenses", permanent: false },
      {
        source: `${base}/cost-pools/:path*`,
        destination: "/companies/:id/costs/ms-licenses/:path*",
        permanent: false,
      },
    ];
  },
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
