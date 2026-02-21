'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/auth.store';
import { useChatStore } from '@/store/chat.store';
import {
  LayoutDashboard, MessageSquare, CreditCard,
  LogOut, Wifi, ChevronRight, Bot, Calendar
} from 'lucide-react';
import clsx from 'clsx';

interface SidebarProps {
  onLogout: () => void;
}

const NAV = [
  { href: '/dashboard',           label: 'Dashboard',       icon: LayoutDashboard },
  { href: '/dashboard/chats',     label: 'Chats',           icon: MessageSquare },
  { href: '/dashboard/payments',  label: 'Pagos',           icon: CreditCard },
  { href: '/dashboard/scheduler', label: 'Automatizaciones',icon: Calendar },
];

export default function Sidebar({ onLogout }: SidebarProps) {
  const pathname = usePathname();
  const { agent } = useAuthStore();
  const { unreadTotal } = useChatStore();

  return (
    <aside className="w-16 xl:w-64 h-full flex flex-col border-r border-slate-800/60 bg-[#0d1424] shrink-0">
      {/* Logo */}
      <div className="p-4 xl:p-5 border-b border-slate-800/60">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
            <Wifi className="w-4 h-4 text-blue-400" />
          </div>
          <div className="hidden xl:block overflow-hidden">
            <p className="text-sm font-semibold text-white truncate">FiberPeru</p>
            <p className="text-xs text-slate-500 truncate">Panel WhatsApp</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + '/');
          const hasUnread = href === '/chats' && unreadTotal > 0;

          return (
            <Link key={href} href={href}>
              <div className={clsx('sidebar-item', isActive && 'active')}>
                <div className="relative shrink-0">
                  <Icon className="w-5 h-5" />
                  {hasUnread && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full text-[9px] font-bold text-white flex items-center justify-center">
                      {unreadTotal > 9 ? '9+' : unreadTotal}
                    </span>
                  )}
                </div>
                <span className="hidden xl:block flex-1">{label}</span>
                {isActive && <ChevronRight className="hidden xl:block w-3.5 h-3.5 shrink-0" />}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Bot status indicator */}
      <div className="px-3 pb-2 hidden xl:block">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-green-500/10 border border-green-500/20">
          <Bot className="w-4 h-4 text-green-400 shrink-0" />
          <div className="overflow-hidden">
            <p className="text-xs font-medium text-green-400 truncate">Bot Activo</p>
            <p className="text-[10px] text-slate-500 truncate">IA procesando pagos</p>
          </div>
          <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse shrink-0 ml-auto" />
        </div>
      </div>

      {/* Agent info */}
      <div className="p-3 border-t border-slate-800/60">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
            {agent?.name?.charAt(0)?.toUpperCase() || 'A'}
          </div>
          <div className="hidden xl:block flex-1 overflow-hidden">
            <p className="text-sm font-medium text-white truncate">{agent?.name}</p>
            <p className="text-xs text-slate-500 capitalize truncate">{agent?.role}</p>
          </div>
          <button
            onClick={onLogout}
            className="hidden xl:flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all"
            title="Cerrar sesión"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>

        {/* Mobile logout */}
        <button
          onClick={onLogout}
          className="xl:hidden w-full mt-2 flex items-center justify-center text-slate-600 hover:text-red-400"
          title="Cerrar sesión"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
