export default function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={wide ? { maxWidth: 760 } : undefined}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
