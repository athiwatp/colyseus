import * as msgpack from "msgpack-lite";
import * as fossilDelta from "fossil-delta";
import * as shortid from "shortid";

import ClockTimer from "clock-timer.js";
import { EventEmitter } from "events";
import { createTimeline, Timeline } from "timeframe";

import { Client } from "./index";
import { Protocol } from "./Protocol";
import { logError, spliceOne, toJSON } from "./Utils";

export abstract class Room<T> extends EventEmitter {

  public clock: ClockTimer = new ClockTimer();
  public timeline?: Timeline;

  public roomId: number;
  public roomName: string;

  protected clients: Client[] = [];
  protected options: any;

  public state: T;
  protected _previousState: any;

  private _simulationInterval: NodeJS.Timer;
  private _patchInterval: number;

  constructor ( options: any = {} ) {
    super()

    this.roomId = options.roomId;
    this.roomName = options.roomName;

    this.options = options;

    // Default patch rate is 20fps (50ms)
    this.setPatchRate( 1000 / 20 );
  }

  abstract onMessage (client: Client, data: any): void;
  abstract onJoin (client: Client, options?: any): void;
  abstract onLeave (client: Client): void;
  abstract onDispose (): void;

  public requestJoin (options: any): boolean {
    return true;
  }

  public setSimulationInterval ( callback: Function, delay: number = 1000 / 60 ): void {
    // clear previous interval in case called setSimulationInterval more than once
    if ( this._simulationInterval ) clearInterval( this._simulationInterval );

    this._simulationInterval = setInterval( () => {
      this.clock.tick();
      callback();
    }, delay );
  }

  public setPatchRate ( milliseconds: number ): void {
    // clear previous interval in case called setPatchRate more than once
    if ( this._patchInterval ) clearInterval(this._patchInterval);

    this._patchInterval = setInterval( this.broadcastPatch.bind(this), milliseconds );
  }

  public useTimeline ( maxSnapshots: number = 10 ): void {
    this.timeline = createTimeline( maxSnapshots );
  }

  public setState (newState) {
    this.clock.start();

    this._previousState = this.getEncodedState();
    this.state = newState;

    if ( this.timeline ) {
      this.timeline.takeSnapshot( this.state );
    }
  }

  public lock (): void {
    this.emit('lock');
  }

  public unlock (): void {
    this.emit('unlock');
  }

  public send (client: Client, data: any): void {
    client.send( msgpack.encode( [Protocol.ROOM_DATA, this.roomId, data] ), { binary: true }, logError.bind(this) );
  }

  public broadcast (data: any): boolean {
    // no data given, try to broadcast patched state
    if (!data) {
      throw new Error("Room#broadcast: 'data' is required to broadcast.");
    }

    // encode all messages with msgpack
    if (!(data instanceof Buffer)) {
      data = msgpack.encode([Protocol.ROOM_DATA, this.roomId, data]);
    }

    var numClients = this.clients.length;
    while (numClients--) {
      this.clients[ numClients ].send(data, { binary: true }, logError.bind(this) );
    }

    return true;
  }

  public disconnect (): void {
    var i = this.clients.length;
    while (i--) {
      this._onLeave(this.clients[i]);
    }
  }

  protected sendState (client: Client): void {
    client.send( msgpack.encode( [
      Protocol.ROOM_STATE,
      this.roomId,
      toJSON( this.state ),
      this.clock.currentTime,
      this.clock.elapsedTime,
    ] ), {
      binary: true
    }, logError.bind(this) );
  }

  private broadcastState (): boolean {
    return this.broadcast( msgpack.encode([
      Protocol.ROOM_STATE,
      this.roomId,
      toJSON( this.state )
    ]) );
  }

  private broadcastPatch (): boolean {
    if ( !this._previousState ) {
      throw new Error( 'trying to broadcast null state. you should call #setState on constructor or during user connection.' );
    }

    let newState = this.getEncodedState();

    // skip if state has not changed.
    if ( newState.equals( this._previousState ) ) {
      return false;
    }

    let patches = fossilDelta.create( this._previousState, newState );

    // take a snapshot of the current state
    if (this.timeline) {
      this.timeline.takeSnapshot( this.state, this.clock.elapsedTime );
    }

    this._previousState = newState;

    // broadcast patches (diff state) to all clients,
    // even if nothing has changed in order to calculate PING on client-side
    return this.broadcast( msgpack.encode([ Protocol.ROOM_STATE_PATCH, this.roomId, patches ]) );
  }

  private _onJoin (client: Client, options?: any): void {
    this.clients.push( client );

    // confirm room id that matches the room name requested to join
    client.send( msgpack.encode( [Protocol.JOIN_ROOM, this.roomId, this.roomName] ), { binary: true }, logError.bind(this) );

    // send current state when new client joins the room
    if (this.state) {
      this.sendState(client);
    }

    if (this.onJoin) {
      this.onJoin(client, options);
    }
  }

  private _onLeave (client: Client, isDisconnect: boolean = false): void {
    // remove client from client list
    spliceOne(this.clients, this.clients.indexOf(client));

    if (this.onLeave) this.onLeave(client);

    this.emit('leave', client, isDisconnect);

    if (!isDisconnect) {
      client.send( msgpack.encode( [Protocol.LEAVE_ROOM, this.roomId] ), { binary: true }, logError.bind(this) );
    }

    // custom cleanup method & clear intervals
    if ( this.clients.length == 0 ) {
      if ( this.onDispose ) this.onDispose();
      if ( this._patchInterval ) clearInterval( this._patchInterval );
      if ( this._simulationInterval ) clearInterval( this._simulationInterval );

      this.emit('dispose');
    }
  }

  private getEncodedState () {
    return msgpack.encode( toJSON( this.state ) );
  }

}
