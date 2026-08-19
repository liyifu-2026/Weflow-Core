export function mount(container: HTMLElement) {
  container.innerHTML = `
    <div style="padding:20px;border:1px dashed #16775b;border-radius:10px;background:rgba(22,119,91,0.08);">
      <h3 style="margin:0 0 8px;color:#16775b;">远程组件已加载</h3>
      <p style="margin:0;color:#6b716d;">这是通过动态 ES Module 加载的远程模块（mount 模式）。</p>
    </div>
  `;
}
