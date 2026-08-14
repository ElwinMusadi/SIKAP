// ============================================================
// JS_Router.html — SPA Navigation Router
// ============================================================

SIKAP.Router = {};

/**
 * Navigation map — defines which views each role can access.
 * This is a FRONTEND convenience only. Backend validates separately.
 */
SIKAP.Router.routes = {
  'Admin': [
    'view-dashboard-admin',
    'view-profil-pegawai',
    'view-arsip-dokumen',
    'view-master-data-pegawai',
    'view-verifikasi-dokumen',
    'view-pengaturan'
  ],
  'Pegawai': [
    'view-dashboard-pegawai',
    'view-profil-pegawai',
    'view-arsip-dokumen',
    'view-pengaturan'
  ]
};

/**
 * Navigates to a view.
 * Verifies the user has frontend-level access before switching.
 * @param {string} viewId - The view DOM id to navigate to.
 */
SIKAP.Router.navigate = function(viewId) {
  var user = SIKAP.state.user;
  var token = SIKAP.state.token;
  
  // If not logged in or no token, redirect to login
  if (!user || !token) {
    SIKAP.Auth.handleSessionExpired();
    return;
  }
  
  // If must change password, restrict navigation
  if (user.forceChangePassword) {
    SIKAP.UI.showView('view-force-change-password');
    return;
  }
  
  // Check if route is allowed for this role
  var allowed = SIKAP.Router.routes[user.role] || [];
  if (allowed.indexOf(viewId) === -1) {
    SIKAP.Toast.show('Anda tidak memiliki akses ke halaman ini.', 'error');
    return;
  }
  
  SIKAP.UI.showView(viewId);
};

/**
 * Session heartbeat — periodically validates the session server-side.
 * Runs every 5 minutes to detect expired sessions proactively.
 */
SIKAP.Router.startHeartbeat = function() {
  setInterval(function() {
    if (!SIKAP.state.token) return;
    
    google.script.run
      .withSuccessHandler(function(result) {
        if (!result.success) {
          SIKAP.Auth.handleSessionExpired();
        }
      })
      .withFailureHandler(function() {
        // Network error — don't force logout, user might be offline temporarily
      })
      .checkSession(SIKAP.state.token);
  }, 5 * 60 * 1000); // 5 minutes
};

/**
 * Sets up click handlers for sidebar navigation.
 * Uses event delegation on the sidebar container.
 */
SIKAP.Router.init = function() {
  var sidebar = document.getElementById('app-sidebar');
  if (!sidebar) return;
  
  sidebar.addEventListener('click', function(e) {
    var link = e.target.closest('a[data-view]');
    if (link) {
      e.preventDefault();
      var viewId = link.getAttribute('data-view');
      SIKAP.Router.navigate(viewId);
    }
  });
};

// Initialize router when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  SIKAP.Router.init();
});
