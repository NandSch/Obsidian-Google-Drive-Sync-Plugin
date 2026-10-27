// Test double for the public Obsidian surface used by the local filesystem adapter.
export class TFile { constructor(public path:string,public stat:{size:number}){} }
export class TFolder { constructor(public path:string){} }
export class FileSystemAdapter {
  constructor(private root:string){}
  getBasePath():string{return this.root;}
}
export class TextFileView {
  constructor(public file:TFile){}
  async save():Promise<void>{}
}
export class MarkdownView extends TextFileView {
  constructor(file:TFile,public editor:{getValue:()=>string}){super(file);}
}
export class Plugin {
  callbacks:(()=>void)[]=[];
  constructor(public app:unknown,public manifest:unknown){}
  register(callback:()=>void):void{this.callbacks.push(callback);}
  registerEvent(_event:unknown):void{}
}
export class PluginSettingTab {}
export class Modal {}
export class Notice {
  static instances:Notice[]=[];
  messageEl:HTMLElement;
  hidden=false;
  constructor(message:string|DocumentFragment,public duration?:number){
    this.messageEl=typeof document==='undefined'?{} as HTMLElement:document.createElement('div');
    if(typeof message!=='string')this.messageEl.appendChild(message);
    if('isConnected' in this.messageEl)Object.defineProperty(this.messageEl,'isConnected',{value:true,configurable:true});
    Notice.instances.push(this);
  }
  hide():void{this.hidden=true;if('isConnected' in this.messageEl)Object.defineProperty(this.messageEl,'isConnected',{value:false,configurable:true});}
}
export class Setting {}
