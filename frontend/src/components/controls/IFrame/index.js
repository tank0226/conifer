import React, { Component } from 'react';
import PropTypes from 'prop-types';

import config from 'config';
import WebSocketHandler from 'helpers/ws';

import { autopilotReady, toggleAutopilot, updateBehaviorState, updateBehaviorMessage } from 'store/modules/automation';
import { setMethod, updateTimestamp, updateUrl } from 'store/modules/controls';

import { apiFetch, setTitle } from 'helpers/utils';
import { toggleModal } from 'store/modules/bugReport';

import './style.scss';


class IFrame extends Component {
  static propTypes = {
    activeBookmarkId: PropTypes.string,
    auth: PropTypes.object,
    appPrefix: PropTypes.oneOfType([PropTypes.func, PropTypes.string]),
    behavior: PropTypes.string,
    contentPrefix: PropTypes.oneOfType([PropTypes.func, PropTypes.string]),
    dispatch: PropTypes.func,
    params: PropTypes.object,
    passEvents: PropTypes.bool,
    timestamp: PropTypes.string,
    url: PropTypes.string
  };

  constructor(props) {
    super(props);

    this.initialReq = true;
    this.socket = null;

    this.contentFrame = null;
    this.frameContainer = null;
    this.internalUpdate = false;
  }

  componentDidMount() {
    const { appPrefix, contentPrefix, currMode, dispatch, params, url } = this.props;

    window.addEventListener('message', this.handleReplayEvent);

    // TODO: fill out wbinfo
    window.wbinfo = {
      outer_prefix: '',
      content_prefix: contentPrefix,
      coll: params.coll,
      url,
      capture_url: '',
      reqTimestamp: params.ts,
      timestamp: params.ts,
      is_frame: true,
      frame_mod: '',
      replay_mod: '',
      state: currMode,
      sources: [],
      inv_sources: ''
    };

    this.contentFrame = new ContentFrame({
      url,
      prefix: typeof appPrefix !== 'string' ? appPrefix() : appPrefix,
      content_prefix: typeof contentPrefix !== 'string' ? contentPrefix() : contentPrefix,
      request_ts: params.ts,
      iframe: this.iframe
    });

    this.socket = new WebSocketHandler(params, currMode, dispatch);
  }

  componentDidUpdate(prevProps) {
    const { activeBookmarkId, appPrefix, behavior, contentPrefix, url, timestamp } = this.props;

    if (behavior !== prevProps.behavior && this.contentFrame) {
      this.contentFrame.iframe.contentWindow.postMessage({
        wb_type: 'behavior',
        name: behavior,
        url,
        start: !!behavior,
      }, '*', undefined, true);

      if (behavior) {
        this.socket.behaviorStat('start', behavior);
      }
    }

    if (prevProps.url !== url || prevProps.timestamp !== timestamp ||
        prevProps.activeBookmarkId !== activeBookmarkId) {
      // check whether this is an update from the content frame or user action
      if (!this.internalUpdate) {
        if (this.props.currMode.includes('replay')) {
          this.contentFrame.app_prefix = typeof appPrefix !== 'string' ? appPrefix() : appPrefix;
          this.contentFrame.content_prefix = typeof contentPrefix !== 'string' ? contentPrefix() : contentPrefix;
        }
        this.contentFrame.load_url(url, timestamp);
      }
      this.internalUpdate = false;
    }
  }

  componentWillUnmount() {
    this.contentFrame.close();
    window.removeEventListener('message', this.handleReplayEvent);
    this.socket.close();
  }

  setDomainCookie = (state) => {
    const { auth, params } = this.props;

    let cookie = state.cookie.split(';', 1)[0];
    if (!cookie) {
      return;
    }
    cookie = cookie.split('=', 2);

    if (!this.socket.addCookie(cookie[0], cookie[1], state.domain)) {
      apiFetch(`/auth/cookie?user=${auth.getIn(['user', 'username'])}`, {
        domain: state.domain,
        name: cookie[0],
        rec: params.rec || '',
        value: cookie[1]
      }, { method: 'POST' });
    }
  }

  setUrl = (url, noStatsUpdate = false) => {
    const rawUrl = decodeURI(url);

    if (this.props.url !== rawUrl) {
      this.internalUpdate = true;
      this.props.dispatch(updateUrl(rawUrl));
    }

    if (!noStatsUpdate) {
      this.socket.setStatsUrls([rawUrl]);
    }
  }

  handleReplayEvent = (evt) => {
    // ignore postMessages from other sources
    if (evt.origin.indexOf(config.contentHost) === -1 || typeof evt.data !== 'object') {
      return;
    }

    const state = evt.data;
    const specialModes = ['cookie', 'skipreq', 'bug-report'].indexOf(state.wb_type) !== -1;

    if (!this.iframe || (evt.source !== this.iframe.contentWindow && !specialModes)) {
      return;
    }

    switch(state.wb_type) {
      case 'behaviorDone':
        this.socket.behaviorStat('done', this.props.behavior);
        this.props.dispatch(toggleAutopilot(null, 'complete', this.props.url));
        this.props.dispatch(updateBehaviorMessage('Behavior Done'));
        break;
      case 'behaviorStop':
        this.props.dispatch(toggleAutopilot(null, 'stopped', this.props.url));
        this.props.dispatch(updateBehaviorMessage('Behavior Stopped By User'));
        break;
      case 'behaviorStep':
        this.props.dispatch(updateBehaviorState(state.result));
        break;
      case 'load':
        if (state.readyState === "interactive") {
          this.props.dispatch(setMethod('navigation'));
          // for now, until wombat includes this flag
          state.newPage = true;
          this.addNewPage(state, true);
        } else if (state.readyState === "complete") {
          this.props.dispatch(autopilotReady());
        }
        break;
      case 'cookie':
        this.setDomainCookie(state);
        break;
      case 'snapshot':
        break;
      case 'skipreq':
        this.addSkipReq(state);
        break;
      case 'hashchange': {
        let url = this.props.url.split("#", 1)[0];
        if (state.hash) {
          url += state.hash;
        }
        this.props.dispatch(setMethod('hash'));
        this.setUrl(url);
        break;
      }
      case 'replace-url':
        this.props.dispatch(setMethod('history'));
        this.addNewPage(state, false);
        break;
      case 'bug-report':
        this.props.dispatch(toggleModal(true));
        break;
      default:
        break;
    }
  }

  addNewPage = (state, doAdd = false) => {
    const { currMode, params, timestamp } = this.props;

    // if (state && state.ts && currMode !== 'record' && currMode.indexOf('extract') === -1 && state.ts !== timestamp) {
    //   this.props.dispatch(updateTimestamp(state.ts));
    // }

    if (state.is_error) {
      this.setUrl(state.url);
    } else if (['record', 'patch', 'extract', 'extract_only'].includes(currMode)) {
      if (state.ts) {
        if (state.ts !== timestamp) {
          this.internalUpdate = true;
          this.props.dispatch(updateTimestamp(state.ts));
        }

        window.wbinfo.timestamp = state.ts;
      }

      this.setUrl(state.url, true);

      const modeMsg = { record: 'recording', patch: 'Patching', extract: 'Extracting' };
      setTitle(currMode in modeMsg ? modeMsg[currMode] : '', state.url, state.tittle);

      if (doAdd && state.newPage && (state.ts || currMode !== 'patch')) {
        if (!this.socket.addPage(state)) {
          apiFetch(`/recording/${params.rec}/pages?user=${params.user}&coll=${params.coll}`, state, { method: 'POST' });
        }
      }
    } else if (['replay', 'replay-coll'].includes(currMode)) {
      if (!this.initialReq) {
        if (state.ts !== timestamp) {
          this.internalUpdate = true;
          this.props.dispatch(updateTimestamp(state.ts));
        }

        this.setUrl(state.url);
        setTitle('Archives', state.url, state.title);
      }
      this.initialReq = false;
    }
  }

  addSkipReq = (state) => {
    if (!this.socket.addSkipReq(state.url)) {
      apiFetch('/auth/skipreq', {
        url: state.url
      }, { method: 'POST' });
    }
  }

  render() {
    const { passEvents } = this.props;

    return (
      <iframe className="wb_iframe" allow="autoplay, fullscreen" style={passEvents ? { pointerEvents: 'none' } : {}} ref={(obj) => { this.iframe = obj; }} />
    );
  }
}


export default IFrame;
