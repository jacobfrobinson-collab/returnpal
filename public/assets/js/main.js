(function ($) {
  "use strict";

  // data-background
  $(document).on("ready", function () {
    $("[data-background]").each(function () {
      $(this).css("background-image", "url(" + $(this).attr("data-background") + ")");
    });
  });

  // sidebar popup
  $(".sidebar-btn").on("click", function () {
    $(".sidebar-popup").addClass("open");
    $(".sidebar-wrapper").addClass("open");
  });
  $(".close-sidebar-popup, .sidebar-popup").on("click", function () {
    $(".sidebar-popup").removeClass("open");
    $(".sidebar-wrapper").removeClass("open");
  });

  // wow init
  new WOW().init();

  // preloader
  $(window).on("load", function () {
    $(".preloader").fadeOut("slow");
  });

  // scroll to top
  $(window).on("scroll", function () {
    if (document.body.scrollTop > 100 || document.documentElement.scrollTop > 100) {
      $("#scroll-top").addClass("active");
    } else {
      $("#scroll-top").removeClass("active");
    }
  });

  $("#scroll-top").on("click", function () {
    $("html, body").animate({ scrollTop: 0 }, 1500);
    return false;
  });

  // header shadow on scroll (header is already sticky)
  $(window).on("scroll", function () {
    if ($(this).scrollTop() > 20) {
      $("#main-header").addClass("scrolled");
    } else {
      $("#main-header").removeClass("scrolled");
    }
  });

  // copywrite date
  let date = new Date().getFullYear();
  $("#date").html(date);

  // auth password view
  $(".password-view").on("click", function () {
    var pwd = document.getElementById("password");
    if (pwd.type === "password") {
      pwd.type = "text";
      $(this).addClass("show");
    } else {
      pwd.type = "password";
      $(this).removeClass("show");
    }
  });

  // counting (hero recovered amount: parse £ and display with £)
  $(document).ready(function () {
    let counted = false;
    function startCounter() {
      let $counter = $("#counter");
      let raw = $counter.text().replace(/[£$,]/g, "").trim();
      let target = parseFloat(raw);
      if (isNaN(target)) target = 452501.58;
      let duration = 3000;
      $({ count: 0 }).animate(
        { count: target },
        {
          duration: duration,
          easing: "swing",
          step: function () {
            $counter.text(
              "£" +
                this.count.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
            );
          },
          complete: function () {
            $counter.text(
              "£" +
                target.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
            );
          },
        }
      );
    }
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !counted) {
            counted = true;
            startCounter();
          }
        });
      },
      {
        threshold: 0.5,
      }
    );
    observer.observe(document.querySelector(".recover"));
  });

  // scroll (only for same-page anchor links; let other footer links navigate normally)
  $(document).ready(function () {
    $('.nav-link[href^="#"], .footer-list a[href^="#"]').on('click', function (e) {
      e.preventDefault();

      const target = $(this.getAttribute('href'));

      if (!target.length) return;

      $('html, body').animate(
        {
          scrollTop: target.offset().top - 70
        },
        600
      );
    });
  });

  // bootstrap tooltip enable
  const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
  const tooltipList = [...tooltipTriggerList].map((tooltipTriggerEl) => new bootstrap.Tooltip(tooltipTriggerEl));

  // Exit-intent / scroll CTA: show once per session when user scrolls past 55% or moves cursor toward leave
  $(document).ready(function () {
    var exitCtaShown = false;
    try { exitCtaShown = sessionStorage.getItem('rp_exit_cta_shown') === '1'; } catch (e) {}
    var modal = document.getElementById('rp-exit-cta-modal');
    if (!modal || exitCtaShown) return;
    function showExitCta() {
      if (exitCtaShown) return;
      exitCtaShown = true;
      try { sessionStorage.setItem('rp_exit_cta_shown', '1'); } catch (e) {}
      var bs = window.bootstrap && bootstrap.Modal;
      if (bs) new bs(modal).show();
    }
    $(window).on('scroll', function () {
      var scrollPercent = ($(window).scrollTop() + $(window).height()) / $(document).height();
      if (scrollPercent > 0.55) showExitCta();
    });
    $(document).on('mouseleave', function (e) {
      if (e.clientY <= 0) showExitCta();
    });
  });
})(jQuery);
