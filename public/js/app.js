/* ============================================
   Campaign Dashboard — Main JS
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {

    // ---- Sidebar toggle (mobile) ----
    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            sidebarOverlay?.classList.toggle('show');
        });
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('show');
        });
    }

    // ---- Sidebar collapsible sections ----
    document.querySelectorAll('[data-collapse]').forEach(trigger => {
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = trigger.getAttribute('data-collapse');
            const subnav = document.getElementById(targetId);
            const icon = trigger.querySelector('.sidebar-toggle-icon');

            if (subnav) {
                subnav.classList.toggle('open');
                icon?.classList.toggle('rotated');
            }
        });
    });

    // ---- User dropdown ----
    const dropdownBtn = document.getElementById('userDropdownBtn');
    const dropdownMenu = document.getElementById('userDropdownMenu');

    if (dropdownBtn && dropdownMenu) {
        dropdownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdownMenu.classList.toggle('show');
        });
        document.addEventListener('click', () => {
            dropdownMenu.classList.remove('show');
        });
    }

    // ---- Client-side table sorting (history page) ----
    document.querySelectorAll('table[data-sortable] thead th').forEach((th, colIndex) => {
        th.addEventListener('click', () => {
            const table = th.closest('table');
            const tbody = table.querySelector('tbody');
            const rows = Array.from(tbody.querySelectorAll('tr'));

            const currentDir = th.getAttribute('data-sort-dir') || 'asc';
            const newDir = currentDir === 'asc' ? 'desc' : 'asc';

            // Reset all headers
            table.querySelectorAll('thead th').forEach(h => {
                h.removeAttribute('data-sort-dir');
                h.classList.remove('sort-active');
            });
            th.setAttribute('data-sort-dir', newDir);
            th.classList.add('sort-active');

            rows.sort((a, b) => {
                const aText = a.cells[colIndex]?.textContent.trim() || '';
                const bText = b.cells[colIndex]?.textContent.trim() || '';

                // Try numeric comparison first
                const aNum = parseFloat(aText);
                const bNum = parseFloat(bText);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return newDir === 'asc' ? aNum - bNum : bNum - aNum;
                }
                return newDir === 'asc'
                    ? aText.localeCompare(bText, 'pt-BR')
                    : bText.localeCompare(aText, 'pt-BR');
            });

            rows.forEach(row => tbody.appendChild(row));
        });
    });
});
