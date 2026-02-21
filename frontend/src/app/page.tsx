'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const token = localStorage.getItem('wp_token');
    router.replace(token ? '/dashboard' : '/login');
  }, [router]);

  return (
    <div className="h-screen flex items-center justify-center bg-[#0a0f1e]">
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
