'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Redirect: la ruta correcta ahora es /dashboard/chats
export default function ChatsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboard/chats'); }, [router]);
  return (
    <div className="h-screen flex items-center justify-center bg-[#0a0f1e]">
      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
