export type WorkEditor=(()=>void)&{open(id?:string):Promise<void>;canLeave():boolean};
export type WorkEditorOptions={host:HTMLElement;back():void};
