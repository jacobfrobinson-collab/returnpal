// Use live API by default when backend is running; set useMock: true to use sample data without backend
window.RETURNPAL_CONFIG = window.RETURNPAL_CONFIG || { useMock: false };

// Dark mode (night mode): persist and apply so it works on every dashboard page
(function() {
    var THEME_KEY = 'returnpal_theme';
    var CONFIG_KEY = '__LAHOME_CONFIG__';

    function getTheme() {
        try {
            var stored = localStorage.getItem(THEME_KEY);
            if (stored === 'dark' || stored === 'light') return stored;
            var config = sessionStorage.getItem(CONFIG_KEY);
            if (config) {
                var c = JSON.parse(config);
                if (c && (c.theme === 'dark' || c.theme === 'light')) return c.theme;
            }
        } catch (e) {}
        return 'light';
    }

    function setTheme(theme) {
        document.documentElement.setAttribute('data-bs-theme', theme);
        localStorage.setItem(THEME_KEY, theme);
        try {
            var config = sessionStorage.getItem(CONFIG_KEY);
            config = config ? JSON.parse(config) : {};
            config.theme = theme;
            sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
            if (window.config) window.config.theme = theme;
        } catch (e) {}
    }

    function applyThemeOnLoad() {
        setTheme(getTheme());
    }

    function initThemeToggle() {
        var btn = document.getElementById('light-dark-mode');
        if (!btn) return;
        btn.addEventListener('click', function() {
            var next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
            setTheme(next);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            applyThemeOnLoad();
            initThemeToggle();
        });
    } else {
        applyThemeOnLoad();
        initThemeToggle();
    }
})();

// Mobile menu toggle functionality
$('.button-mob-menu').on('click', function () {
    $('body').toggleClass('show-mob-menu');
});

$(window).on('resize', function() {
    if (window.matchMedia("(min-width: 1200px)").matches) {
        $('html').attr('data-menu-size', 'default');
        $('html').removeClass('sidebar-enable');
    }
}).trigger('resize');

$(window).on('resize', function() {
    if (window.matchMedia("(max-width: 1199.98px)").matches) {
        $('html').attr('data-menu-size', 'hidden');
    }
}).trigger('resize');
    
// Dropzone (only on packages page)
var dropzonePreviewNode = document.querySelector("#dropzone-preview-list");
if (dropzonePreviewNode) {
    dropzonePreviewNode.id = "";
    var previewTemplate = dropzonePreviewNode.parentNode.innerHTML;
    dropzonePreviewNode.parentNode.removeChild(dropzonePreviewNode);

    if (typeof Dropzone !== 'undefined') {
        var dropzone = new Dropzone(".dropzone", {
            url: "/api/upload/packages",
            method: "post",
            headers: { "Authorization": "Bearer " + (localStorage.getItem('returnpal_token') || '') },
            previewTemplate: previewTemplate,
            previewsContainer: "#dropzone-preview",
            acceptedFiles: ".xlsx,.csv",
            dictInvalidFileType: "Only Excel (.xlsx) and CSV files are allowed.",
            init: function () {
                this.on("error", function (file, message) {
                    console.error(message);
                });
                this.on("success", function(file, response) {
                    if (response.message) {
                        alert(response.message);
                        if (typeof Dashboard !== 'undefined') Dashboard.loadPackages();
                    }
                });
            },
        });
    }
}

// Add new product row
$(document).ready(function () {
    $(document).on('click', '.add-new', function () {
        let modal = $(this).closest('.modal');
        let wrapper = modal.find('.product-wrapper');

        let newRow = `
        <div class="product-row bg-light rounded p-2 grid grid-cols-12 gap-2 align-items-end mb-1">
            <div class="g-col-5 space-y-1">
                <label class="form-label">Product Name / SKU</label>
                <input type="text" class="form-control" placeholder="e.g., iPhone Case">
            </div>

            <div class="g-col-2 space-y-1">
                <label class="form-label">Qty</label>
                <input type="number" class="form-control" value="1" min="1">
            </div>

            <div class="g-col-4 space-y-1">
                <label class="form-label">Condition</label>
                <select class="form-select">
                    <option>New</option>
                    <option>Used</option>
                    <option>Return</option>
                    <option>Return Review</option>
                </select>
            </div>

            <div class="g-col-1 d-flex justify-content-end">
                <button class="btn btn-sm btn-light remove-row">
                    <i class="ri-delete-bin-line fs-18"></i>
                </button>
            </div>
        </div>`;

        wrapper.append(newRow);
        toggleRemoveButtons(modal);
    });

    // Remove product row (scoped)
    $(document).on('click', '.remove-row', function () {
        let modal = $(this).closest('.modal');
        $(this).closest('.product-row').remove();
        toggleRemoveButtons(modal);
    });

    // Enable / disable delete button per modal
    function toggleRemoveButtons(modal) {
        let rows = modal.find('.product-row');
        let buttons = modal.find('.remove-row');

        if (rows.length === 1) {
            buttons.prop('disabled', true);
        } else {
            buttons.prop('disabled', false);
        }
    }

    // When modal opens, reset delete button state
    $('.modal').on('shown.bs.modal', function () {
        toggleRemoveButtons($(this));
    });

});