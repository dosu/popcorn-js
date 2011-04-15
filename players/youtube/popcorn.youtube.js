// Popcorn Youtube Player Wrapper

var onYouTubePlayerReady;

( function( Popcorn ) {
  /**
   * Youtube wrapper for popcorn.
   * This plug-in adds capability for Popcorn.js to deal with Youtube
   * videos. This plug-in also doesn't use Popcorn's plugin() API and
   * instead hacks directly into Popcorn's core.
   *
   * To use this plug-in, onYouTubePlayerReady() event handler needs to be
   * called by the Youtube video player, before videos can be registered.
   * Once videos are registered, calls to them can be made the same way as
   * regular Popcorn objects. Also note that enablejsapi=1 needs to be added
   * to the embed code, in order for Youtube's JavaScript API to work.
   *
   * Note that there are a few methods, properties and events that are not
   * supported. See the bottom of this plug-in for a complete list.
   */

  // Intended
  var undef;

  // Config parameters
  // 33 ms per update is suitable for 30 fps
  // 0.05 sec tolerance between old and new times to determine if currentTime has been set programatically
  // 250 ms progress interval as specified by WHATWG
  var timeupdateInterval = 33,
      timeCheckInterval = 0.5
      progressInterval = 250;

  // Ready State Constants
  var READY_STATE_HAVE_NOTHING = 0,
      READY_STATE_HAVE_METADATA = 1,
      READY_STATE_HAVE_CURRENT_DATA = 2,
      READY_STATE_HAVE_FUTURE_DATA = 3,
      READY_STATE_HAVE_ENOUGH_DATA = 4;

  // Youtube State Constants
  var YOUTUBE_STATE_UNSTARTED = -1,
      YOUTUBE_STATE_ENDED = 0,
      YOUTUBE_STATE_PLAYING = 1,
      YOUTUBE_STATE_PAUSED = 2,
      YOUTUBE_STATE_BUFFERING = 3,
      YOUTUBE_STATE_CUED = 5;
  
  // Collection of all Youtube players
  var registry = {},
      loadedPlayers = {};
      
  var abs = Math.abs;
  
  Popcorn.getScript( "http://ajax.googleapis.com/ajax/libs/swfobject/2.2/swfobject.js" );
  
  // Extract the id from a web url
  function extractIdFromUrl( url ) {
    if ( !url ) {
      return;
    }
    
    var matches = url.match( /((http:\/\/)?www\.)?youtube\.[a-z]+\/watch\?v\=[a-z0-9]+/i );    
    // Return id, which comes after first equals sign
    return matches ? matches[0].split( "=" )[1] : "";
  };
  
  // Extract the id from a player url
  function extractIdFromUri( url ) {
    if ( !url ) {
      return;
    }
    
    var matches = url.match( /^http:\/\/?www\.youtube\.[a-z]+\/e\/[a-z0-9]+/i );
    
    // Return id, which comes after first equals sign
    return matches ? matches[0].split( "/e/" )[1] : ""
  };
  
  function getPlayerAddress( vidId, playerId ) {
    if( !vidId ) {
      return;
    }
    
    return "http://www.youtube.com/e/" + id;
  }
  
  function makeSWF( url, container ) {
    var params,
        flashvars,
        attributes,
        self = this;
        
    if ( !window.swfobject ) {
      setTimeout( function() {
        makeSWF.call( self, url, container );
      }, 1 );
      return;
    }    
        
    // The video id for youtube (web or player formats)
    // First check manually given url, if that doesn't work resort to "src"
    this.vidId = this.vidId || extractIdFromUrl( container.getAttribute( "src" ) ) || extractIdFromUri( container.getAttribute( "src" ) );
    
    if ( !this.vidId ) {
      throw "Could not find video id";
    }
    
    // Determine width/height/etc based on container
    this.width = container.getAttribute("width") || 460;
    this.height = container.getAttribute("height") || 350;
    
    // Just in case we got the attributes as strings. We'll need to do math with these later
    this.width = parseFloat(this.width);
    this.height = parseFloat(this.height);
    
    this.offsetWidth = this.width;
    this.offsetHeight = this.height;
    this.offsetParent = container.offsetParent;
    this.offsetLeft = container.offsetLeft;
    this.offsetTop = container.offsetTop;
    
    flashvars = {
      playerapiid: this.playerId
    };
    params = {
      allowscriptaccess: 'always',
      allowfullscreen: 'true',
      // This is so we can overlay html on top of Flash
      wmode: 'transparent'
    };
    
    attributes = {
      id: this.playerId
    };
    
    swfobject.embedSWF( "http://www.youtube.com/e/" + this.vidId +"?enablejsapi=1&playerapiid=" + this.playerId + "&verion=3", 
                      this.playerId, this.width, this.height, "8", null, flashvars, params, attributes );
  }
  
  // Called when a player is loaded
  // Playerid must match the element id
  onYouTubePlayerReady = function ( playerId ) {
    var vid = registry[playerId];
    
    loadedPlayers[playerId] = 1;
    
    // Video hadn't loaded yet when ctor was called
    vid.video = document.getElementById( playerId );
    vid.duration = vid.video.getDuration();
    
    // Issue load event
    vid.dispatchEvent( 'load' );
    vid.dispatchEvent( "durationchange" );
  }

  Popcorn.youtube = function( elementId, url ) {
    return new Popcorn.youtube.init( elementId, url );
  };

  Popcorn.youtube.init = function( elementId, url ) {
    if ( !elementId ) {
      throw "Element id is invalid.";
    } else if ( /file/.test( location.protocol ) ) {
      throw "This must be run from a web server.";
    }
    
    var self = this,
        container = document.getElementById( elementId );;
    
    this.playerId = elementId;
    this.readyState = READY_STATE_HAVE_NOTHING;
    this.eventListeners = {};
    this.loadStarted = false;
    this.loadedData = false;
    this.fullyLoaded = false;
    this.timeUpdater = null;
    this.progressUpdater = null;
    
    this.currentTime = this.previousCurrentTime = 0;
    this.volume = this.previousVolume = this.preMuteVol = 1;
    this.duration = 0;
    
    this.vidId = extractIdFromUrl( url ) || extractIdFromUri( url );
    
    this.addEventListener( "load", function() {
      // For calculating position relative to video (like subtitles)
      this.offsetWidth = this.video.offsetWidth;
      this.offsetHeight = this.video.offsetHeight;
      this.offsetParent = this.video.offsetParent;
      this.offsetLeft = this.video.offsetLeft;
      this.offsetTop = this.video.offsetTop;
      
      // Set up stuff that requires the API to be loaded
      this.registerYoutubeEventHandlers();
      this.registerInternalEventHandlers();
    });
    
    (function() {
      var hasBeenCalled = 0;
      
      self.addEventListener( "playing", function() {
        if (hasBeenCalled) {
          return;
        }
        
        hasBeenCalled = 1;
        self.duration = self.video.getDuration();
        self.dispatchEvent( "durationchange" );
        
      });
    })();
    
    if ( loadedPlayers[this.playerId] ) {
      this.video = registry[this.playerId].video;
      
      this.vidId = this.vidId || extractIdFromUrl( container.getAttribute( "src" ) ) || extractIdFromUri( container.getAttribute( "src" ) );
      
      if (this.vidId !== registry[this.playerId].vidId ) {
        this.video.cueVideoById( this.vidId );
      } else {
        // Same video, new ctor. Force a seek to the beginning
        this.previousCurrentTime = 1;
      }
      
      this.dispatchEvent( 'load' );
    } else if ( container ) {
      makeSWF.call( this, url, container );
    } else {
      // Container not yet loaded, get it on DOMDontentLoad
      document.addEventListener( "DOMContentLoaded", function() {
        container = document.getElementById( elementId );
        
        if ( !container ) {
          throw "Could not find container!";
        }
        
        makeSWF.call( self, url, container );
      }, false);
    }
    
    registry[this.playerId] = this;
  };
  // end Popcorn.youtube.init

  Popcorn.extend( Popcorn.youtube.init.prototype, {

    // For internal use only.
    // Register handlers to YouTube events.
    registerYoutubeEventHandlers: function() {
      var youcorn = this,
          stateChangeHandler = 'Popcorn.youtube.stateChangeEventHandler',
          errorHandler = 'Popcorn.youtube.errorEventHandler';
          
      this.video.addEventListener( 'onStateChange', stateChangeHandler );
      this.video.addEventListener( 'onError', errorHandler );

      /**
       * Since Flash can only call named functions, they are declared
       * separately here.
       */
      Popcorn.youtube.stateChangeEventHandler = function( state ) {
        // In case ctor has been called many times for many ctors
        // Only use latest ctor call for each player id        
        var self = registry[youcorn.playerId];
        
        if ( state === YOUTUBE_STATE_UNSTARTED ) {
          self.readyState = READY_STATE_HAVE_METADATA;
          self.dispatchEvent( 'loadedmetadata' );
        } else if ( state === YOUTUBE_STATE_ENDED ) {
          self.dispatchEvent( 'ended' );
        } else if ( state === YOUTUBE_STATE_PLAYING ) {
          // Being able to play means current data is loaded.
          if ( !this.loadedData ) {
            this.loadedData = true;
            self.dispatchEvent( 'loadeddata' );
          }

          self.readyState = READY_STATE_HAVE_CURRENT_DATA;
          self.dispatchEvent( 'playing' );
        } else if ( state === YOUTUBE_STATE_PAUSED ) {
          self.dispatchEvent( 'pause' );
        } else if ( state === YOUTUBE_STATE_BUFFERING ) {
          self.dispatchEvent( 'waiting' );
        } else if ( state === YOUTUBE_STATE_CUED ) {
          // not handled
        }
      };

      Popcorn.youtube.errorEventHandler = function( state ) {
        youcorn.dispatchEvent( 'error' );
      };
    },

    // For internal use only.
    // Start current time and loading progress syncing intervals.
    registerInternalEventHandlers: function() {
      this.addEventListener( 'playing', function() {
        this.startTimeUpdater();
      });
      this.addEventListener( 'loadedmetadata', function() {
        this.startProgressUpdater();
      });
    },

    play: function() {
      // In case called before video is loaded, defer acting
      if ( !loadedPlayers[this.playerId] ) {
        this.addEventListener( "load", function() {
          this.play();
        });
        return;
      }
      
      this.dispatchEvent( 'play' );
      this.video.playVideo();
    },

    pause: function() {
      // In case called before video is loaded, defer acting
      if ( !loadedPlayers[this.playerId] ) {
        this.addEventListener( "load", this.pause );
        return;
      }
      
      this.video.pauseVideo();
      // pause event is raised by Youtube.
    },

    load: function() {
      // In case called before video is loaded, defer acting
      if ( !loadedPlayers[this.playerId] ) {
        this.addEventListener( "load", function() {
          this.load();
}          );
        return;
      }
      
      this.video.playVideo();
      this.video.pauseVideo();
    },

    seekTo: function( time ) {      
      var playing = this.video.getPlayerState() == YOUTUBE_STATE_PLAYING;
      this.video.seekTo( time, true );

      // Prevent Youtube's behaviour to start playing video after seeking.
      if ( !playing ) {
        this.video.pauseVideo();
      }

      // Data need to be loaded again.
      if ( !this.fullyLoaded ) {
        this.loadedData = false;
      }

      // Raise event.
      this.dispatchEvent( 'seeked' );
    },

    // Mute is toggleable
    mute: function() {
      // In case called before video is loaded, defer acting
      if ( !loadedPlayers[this.playerId] ) {
        this.addEventListener( "load", this.mute );
        return;
      }
      
      if ( this.volume !== 0 ) {
        this.preMuteVol = this.volume;        
        this.setVolume( 0 );
      } else {
        this.setVolume( this.preMuteVol );
      }
    },

    // Expects beteween 0 and 1
    setVolume: function( vol ) {
      this.volume = this.previousVolume = vol;
      this.video.setVolume( vol * 100 );
      this.dispatchEvent( 'volumechange' );
    },

    addEventListener: function( evt, func ) {
      var evtName = evt.type || evt;
      
      if ( !this.eventListeners[evtName] ) {
        this.eventListeners[evtName] = [];
      }
      
      this.eventListeners[evtName].push( func );
    },

    /**
     * Notify event listeners about an event.
     */
    dispatchEvent: function( name ) {
      var evtName = name.type || name;
      if ( !this.eventListeners[evtName] ) {
        return;
      }
      
      var self = this;
      
      Popcorn.forEach( this.eventListeners[evtName], function( evt ) {
        evt.call( self, null );
      });
    },

    /* Unsupported methods. */

    defaultPlaybackRate: function( arg ) {
    },

    playbackRate: function( arg ) {
    },
    
    startTimeUpdater: function() {
      var state = this.video.getPlayerState(),
          self = this,
          seeked = 0;
      
      if ( abs( this.currentTime - this.previousCurrentTime ) > timeCheckInterval ) {
        // Has programatically set the currentTime
        this.previousCurrentTime = this.currentTime - timeCheckInterval;
        this.seekTo( this.currentTime );
        seeked = 1;
      } else {
        this.previousCurrentTime = this.currentTime;
        this.currentTime = this.video.getCurrentTime();
      }
      
      if ( this.volume !== this.previousVolume ) {
        this.setVolume( this.volume );
      }
      
      if ( state !== YOUTUBE_STATE_ENDED && state !== YOUTUBE_STATE_PAUSED || seeked ) {
        this.dispatchEvent( 'timeupdate' );
      }
      
      if( state !== YOUTUBE_STATE_ENDED ) {
        setTimeout( function() {
          self.startTimeUpdater.call(self);
        }, timeupdateInterval);
      }
    },
    
    startProgressUpdater: function() {
      var bytesLoaded = this.video.getVideoBytesLoaded(),
          bytesToLoad = this.video.getVideoBytesTotal(),
          self = this;

      // do nothing if size is not yet determined
      if ( bytesToLoad == 0 ) {
        return;
      }

      // raise an event if load has just started
      if ( !this.loadStarted ) {
        this.loadStarted = true;
        this.dispatchEvent( 'loadstart' );
      }

      // fully loaded
      if ( bytesLoaded >= bytesToLoad ) {
        this.fullyLoaded = true;
        this.readyState = READY_STATE_HAVE_ENOUGH_DATA;
        this.dispatchEvent( 'canplaythrough' );
        return;
      }

      this.dispatchEvent( 'progress' );
        
      setTimeout( function() {
        self.startProgressUpdater.call( self );
      }, progressInterval);
    }
  }); // end Popcorn.extend

  /* Unsupported properties and events. */

  /**
   * Unsupported events are:
   * * suspend
   * * abort
   * * emptied
   * * stalled
   * * canplay
   * * seeking
   * * ratechange
   */

})( Popcorn );
