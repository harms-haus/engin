import './Header.css';

interface HeaderProps {
  connected: boolean;
}

export function Header({ connected }: HeaderProps) {
  return (
    <header className="header">
      <span className="logo">engin</span>
      <span
        className="connection-dot"
        style={{ backgroundColor: connected ? 'var(--engin-success)' : 'var(--engin-error)' }}
      />
    </header>
  );
}
