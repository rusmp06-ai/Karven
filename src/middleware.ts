import { NextRequest, NextResponse } from 'next/server';
// Authentication and authorization always run again on the server against the database.
export function middleware(request:NextRequest) {
 const response=NextResponse.next();
 response.headers.set('Cache-Control','private, no-store');
 response.headers.set('X-Content-Type-Options','nosniff');
 response.headers.set('X-Frame-Options','DENY');
 response.headers.set('Referrer-Policy','same-origin');
 return response;
}
export const config={matcher:['/((?!_next/static|_next/image|favicon.ico).*)']};
