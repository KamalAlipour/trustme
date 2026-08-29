import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ADMIN_TOKEN_COOKIE } from '../../../../../../../constants';
import { config } from '../../../../../../../config';

export async function GET(_request: Request, { params }: { params: Promise<{ reviewId: string; assetId: string }> }) {
  const token = (await cookies()).get(ADMIN_TOKEN_COOKIE)?.value;
  if (!token) return new NextResponse('Unauthorized', { status: 401 });
  const { reviewId, assetId } = await params;
  const upstream = await fetch(`${config.trustmeApiUrl.replace(/\/$/, '')}/admin/identity-reviews/${encodeURIComponent(reviewId)}/media/${encodeURIComponent(assetId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!upstream.ok) return new NextResponse(null, { status: upstream.status });
  return new NextResponse(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
