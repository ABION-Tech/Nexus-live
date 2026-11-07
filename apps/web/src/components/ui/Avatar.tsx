export interface AvatarProps {
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  return (
    <span className={`nx-avatar nx-avatar--${size}`} title={name}>
      {src ? <img src={src} alt={name} /> : initials(name)}
    </span>
  );
}
