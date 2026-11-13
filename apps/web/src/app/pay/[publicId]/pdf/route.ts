const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_LINK = "This invoice link isn't valid.";
const UNAVAILABLE = "Couldn't get the PDF. Try again in a minute.";

function plain(status: 404 | 502, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * The invoice's PDF from the pay link's own address, so an email can link
 * to the dashboard's origin like the pay page does. The API renders it; this
 * only passes the bytes on and says nothing of what went wrong upstream.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await params;
  if (!PUBLIC_ID_PATTERN.test(publicId)) {
    return plain(404, INVALID_LINK);
  }
  const base = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "");
  if (base === undefined || base === "") {
    return plain(502, UNAVAILABLE);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/pay/${publicId}/pdf`, {
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    return plain(502, UNAVAILABLE);
  }

  if (upstream.status === 404) {
    return plain(404, INVALID_LINK);
  }
  const type = upstream.headers.get("content-type");
  const disposition = upstream.headers.get("content-disposition");
  if (upstream.status !== 200 || type === null || disposition === null) {
    return plain(502, UNAVAILABLE);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
